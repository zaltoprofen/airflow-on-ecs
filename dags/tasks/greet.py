from airflow.operators.python_operator import PythonOperator


def _greet(message):
    print(message)


def greet(
    task_id: str,
    message: str = 'Hello, {{ dag.owner }}!',
    **kwargs,
):
    return PythonOperator(
        task_id=task_id,
        python_callable=_greet,
        op_kwargs={
            'message': message,
        },
        **kwargs,
    )